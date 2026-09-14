import { db } from './db.ts';
import * as events from './services/events.ts';
import * as registrations from './services/registrations.ts';
import * as checkin from './services/checkin.ts';
import * as reviews from './services/reviews.ts';
import * as shares from './services/shares.ts';
import { nowIso, hashAdminPassword } from './util.ts';
import { APP_ENV, ADMIN_USERNAME, ADMIN_PASSWORD } from './config.ts';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';

// ── 种子封面：纯 JS 生成渐变 PNG 写入 uploads/，返回相对 URL（保证首页/详情有缩略图）──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
type RGB = [number, number, number];
type GlowSpec = [gx: number, gy: number, gr: number, gc: RGB, ga: number];
function seedCover(name: string, c1: RGB, c2: RGB, glow?: GlowSpec): string {
  const w = 480, h = 480;
  const stride = 1 + w * 4;
  const raw = Buffer.alloc(h * stride);
  const maxT = w + h - 2;
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < w; x++) {
      const t = (x + y) / maxT;
      const o = y * stride + 1 + x * 4;
      raw[o] = Math.round(c1[0] + (c2[0] - c1[0]) * t);
      raw[o + 1] = Math.round(c1[1] + (c2[1] - c1[1]) * t);
      raw[o + 2] = Math.round(c1[2] + (c2[2] - c1[2]) * t);
      raw[o + 3] = 255;
    }
  }
  if (glow) {
    const [gx, gy, gr, gc, ga] = glow;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - gx, y - gy);
      if (d < gr) {
        const a = (1 - d / gr) * ga;
        const o = y * stride + 1 + x * 4;
        raw[o] = Math.round(raw[o] + (gc[0] - raw[o]) * a);
        raw[o + 1] = Math.round(raw[o + 1] + (gc[1] - raw[o + 1]) * a);
        raw[o + 2] = Math.round(raw[o + 2] + (gc[2] - raw[o + 2]) * a);
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 9 });
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0)),
  ]);
  const dir = path.resolve(import.meta.dirname, '..', 'data', APP_ENV, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), png);
  return `/uploads/${name}`;
}

type Row = Record<string, any>;

const args = process.argv.slice(2);
const reset = args.includes('--reset');

/** 演示用户（openid 唯一）。返回 user id。 */
function ensureUser(openid: string, nickname: string, phone: string): number {
  const ex = db.prepare('SELECT id FROM users WHERE openid=?').get(openid) as Row | undefined;
  if (ex) return Number(ex.id);
  const now = nowIso();
  const res = db
    .prepare('INSERT INTO users (openid, nickname, phone, is_admin, created_at, updated_at) VALUES (?,?,?,0,?,?)')
    .run(openid, nickname, phone, now, now);
  return Number(res.lastInsertRowid);
}

function main(): void {
  if (reset) {
    // 子表先删（外键），再删父表
    db.exec(`
      DELETE FROM checkins;
      DELETE FROM refunds;
      DELETE FROM payments;
      DELETE FROM registrations;
      DELETE FROM registration_options;
      DELETE FROM events;
      DELETE FROM sessions;
      DELETE FROM admin_sessions;
    `);
  }

  const now = nowIso();
  // 演示用户（浏览器联调 harness 用；小程序用户走 wx-login 自建）
  ensureUser('demo_user', '演示用户', '13800000000');
  // 管理端默认账号
  if (!db.prepare(`SELECT id FROM admin_users WHERE username=?`).get(ADMIN_USERNAME)) {
    db.prepare(`INSERT INTO admin_users (username, password_hash, created_at) VALUES (?,?,?)`).run(ADMIN_USERNAME, hashAdminPassword(ADMIN_USERNAME, ADMIN_PASSWORD), now);
  }

  const existing = (db.prepare('SELECT COUNT(*) c FROM events').get() as Row).c;
  if (Number(existing) > 0 && !reset) {
    console.log('已存在活动数据，跳过 seed（如需重置：npm run setup）');
    return;
  }

  const iso = (ms: number) => new Date(ms).toISOString();
  const DAY = 86_400_000;
  const H = 3_600_000;

  // ───────── 活动 1：从 Codex 出发，掌握 AI 时代的底层思维与提效能力（真实品牌活动）─────────
  const ev1 = events.createEvent({
    title: '从 Codex 出发，掌握 AI 时代的底层思维与提效能力',
    subtitle: '零基础友好 · AI 实操工作坊',
    category: '科技',
    coverImage: seedCover('seed_cover_1.png', [47, 84, 235], [29, 57, 196], [70, 40, 260, [255, 255, 255], 0.22]),
    coverDetailImage: seedCover('seed_cover_1.png', [47, 84, 235], [29, 57, 196], [70, 40, 260, [255, 255, 255], 0.22]),
    description: [
      '<h3>关于本场</h3>',
      '<p>「硬核知识 × 微醺社交」学术酒吧系列 · AI 实操工作坊，零基础友好：涵盖 <b>AI 时代理解与判断</b>、<b>Codex 底层思维</b>、<b>AI 产品化闭环</b> 全流程。</p>',
      '<img src="/uploads/seed_cover_1.png" style="max-width:100%;border-radius:10px;margin:12px 0" />',
      '<h3>你将获得</h3>',
      '<ul><li>看懂 AI 能做什么、边界在哪</li><li>掌握 Codex 的底层工作方式</li><li>现场动手完成一个提效闭环</li></ul>',
      '<h3>活动形式</h3>',
      '<p>20:00 开场：嘉宾分享 + 现场实操 + 自由交流，一边喝酒一边学 AI。</p>',
    ].join(''),
    locationName: '深圳 · 南山/前海',
    locationAddress: '深圳市南山区前海（报名后告知具体地址）',
    startTime: iso(Date.now() + 7 * DAY),
    endTime: iso(Date.now() + 7 * DAY + 2 * H),
    registrationStartTime: iso(Date.now() - 1 * H),
    registrationEndTime: iso(Date.now() + 6 * DAY),
    capacity: 60,
    refundRule: 'BEFORE_24H',
    contactInfo: '13800000000',
    status: 'PUBLISHED',
    customFields: [
      { key: 'industry', label: '所在行业', type: 'text' },
      { key: 'company', label: '公司/单位', type: 'text' },
      { key: 'drink', label: '饮品选择', type: 'choice', options: ['有酒', '无酒', '热饮'] },
      { key: 'topic', label: '想听的话题或建议', type: 'textarea' },
    ],
  });
  const ev1Early = events.addRegistrationOption(ev1.id, { name: '早鸟票', price: 8800, sortOrder: 1, description: '限量早鸟', optionType: 'SINGLE', soldLimit: 15 });
  const ev1Std = events.addRegistrationOption(ev1.id, { name: '标准票', price: 11800, sortOrder: 2, description: '标准报名，含酒水小食', optionType: 'SINGLE', soldLimit: 30 });
  const ev1Double = events.addRegistrationOption(ev1.id, { name: '双人同行票', price: 18800, sortOrder: 3, description: '1 人付费、2 人同行，出 2 个核销码各扫各', optionType: 'DOUBLE', soldLimit: 10 });
  const ev1Invite = events.addRegistrationOption(ev1.id, { name: '受邀专享票', price: 12800, sortOrder: 4, description: '受邀专享，需输入购买邀请码', optionType: 'INVITE', gateCode: 'CLINK-2026', soldLimit: 5 });
  const ev1Wait = events.addRegistrationOption(ev1.id, { name: '候补登记', price: 0, sortOrder: 5, description: '名额满员时登记候补，免费仅统计', optionType: 'WAITLIST' });
  void ev1Double; void ev1Invite; void ev1Wait;

  // ───────── 活动 2：跨越命令行鸿沟：和 Claude Code 一起思考和工作 ─────────
  const ev2 = events.createEvent({
    title: '跨越命令行鸿沟：和 Claude Code 一起思考和工作',
    subtitle: '学术酒吧 · 一边喝酒一边学 AI',
    category: '科技',
    coverImage: seedCover('seed_cover_2.png', [114, 46, 209], [83, 29, 171], [420, 60, 250, [255, 255, 255], 0.2]),
    coverDetailImage: seedCover('seed_cover_2.png', [114, 46, 209], [83, 29, 171], [420, 60, 250, [255, 255, 255], 0.2]),
    description: [
      '<h3>关于本场</h3>',
      '<p>别让「命令行恐惧」挡住你。本场在学术酒吧里，带你 <b>跨越命令行鸿沟</b>，和 Claude Code 一起思考与工作。</p>',
      '<h3>嘉宾</h3>',
      '<p><b>秦弋</b>｜湖畔创研中心 321 Lab 研究员 & 合伙人</p>',
      '<h3>你将体验</h3>',
      '<ul><li>Claude Code 真实工作流演示</li><li>从需求到代码的完整思考链路</li><li>微醺自由交流</li></ul>',
    ].join(''),
    locationName: '深圳 · 报名后获取地址',
    locationAddress: '深圳市（报名后获取详细地址）',
    startTime: iso(Date.now() + 14 * DAY),
    endTime: iso(Date.now() + 14 * DAY + 2 * H),
    registrationStartTime: iso(Date.now() - 1 * H),
    registrationEndTime: iso(Date.now() + 13 * DAY),
    capacity: 40,
    refundRule: 'ALLOW_ANY',
    contactInfo: '13800000000',
    status: 'PUBLISHED',
    customFields: [
      { key: 'industry', label: '所在行业', type: 'text' },
      { key: 'company', label: '公司/单位', type: 'text' },
      { key: 'drink', label: '饮品选择', type: 'choice', options: ['有酒', '无酒', '热饮'] },
      { key: 'topic', label: '想听的话题或建议', type: 'textarea' },
    ],
  });
  const ev2Early = events.addRegistrationOption(ev2.id, { name: '早鸟票', price: 6800, sortOrder: 1, description: '限量早鸟', optionType: 'SINGLE', soldLimit: 10 });
  const ev2Std = events.addRegistrationOption(ev2.id, { name: '标准票', price: 8800, sortOrder: 2, description: '标准报名，含酒水小食', optionType: 'SINGLE', soldLimit: 25 });
  const ev2Wait = events.addRegistrationOption(ev2.id, { name: '候补登记', price: 0, sortOrder: 3, description: '名额满员时登记候补，免费仅统计', optionType: 'WAITLIST' });
  void ev2Wait;

  // ───────── 活动 3：碰杯学术酒谈第 75 期 ─────────
  const ev3 = events.createEvent({
    title: '碰杯学术酒谈第 75 期｜复杂度的幻觉：大模型能否理解复杂社会？',
    subtitle: '硬核知识 × 微醺社交',
    category: '综合',
    coverImage: seedCover('seed_cover_3.png', [19, 194, 194], [8, 151, 156], [430, 40, 250, [255, 255, 255], 0.2]),
    coverDetailImage: seedCover('seed_cover_3.png', [19, 194, 194], [8, 151, 156], [430, 40, 250, [255, 255, 255], 0.2]),
    description: [
      '<h3>关于本场</h3>',
      '<p>深圳线下学术沙龙。当大模型处理的不再是数据，而是 <b>复杂社会</b>——它的幻觉从何而来？理解的边界又在哪里？</p>',
      '<h3>嘉宾</h3>',
      '<p><b>张凌</b>｜外资机构首席经济学家，清华大学物理系本硕</p>',
      '<h3>你将收获</h3>',
      '<ul><li>数理与系统视角下的大模型边界</li><li>复杂社会问题的建模思路</li><li>品酒 + 深度自由讨论</li></ul>',
    ].join(''),
    locationName: '深圳 · 南山',
    locationAddress: '深圳市南山区梦海大道 5188 号前海五号楼 5 楼 D+ 咖啡厅',
    latitude: 22.5289,
    longitude: 113.904,
    startTime: iso(Date.now() + 21 * DAY),
    endTime: iso(Date.now() + 21 * DAY + 2 * H),
    registrationStartTime: iso(Date.now() - 1 * H),
    registrationEndTime: iso(Date.now() + 20 * DAY),
    capacity: 50,
    refundRule: 'BEFORE_24H',
    contactInfo: '13800000000',
    status: 'PUBLISHED',
    customFields: [
      { key: 'industry', label: '所在行业', type: 'text' },
      { key: 'company', label: '公司/单位', type: 'text' },
      { key: 'drink', label: '饮品选择', type: 'choice', options: ['有酒', '无酒', '热饮'] },
      { key: 'topic', label: '想听的话题或建议', type: 'textarea' },
    ],
  });
  const ev3Std = events.addRegistrationOption(ev3.id, { name: '标准票', price: 11800, sortOrder: 1, description: '学术酒谈席位，含品酒', optionType: 'SINGLE', soldLimit: 2 });
  const ev3Vip = events.addRegistrationOption(ev3.id, { name: '贵宾票', price: 18800, sortOrder: 2, description: '前排席位 + 资料包 + 与嘉宾小范围交流', optionType: 'SINGLE', soldLimit: 1 });
  const ev3Wait = events.addRegistrationOption(ev3.id, { name: '候补登记', price: 0, sortOrder: 3, description: '名额满员时登记候补，免费仅统计', optionType: 'WAITLIST' });
  void ev3Wait;

  // ───────── 演示报名数据（覆盖各种状态，供后台/签到演示） ─────────
  const uLi = ensureUser('demo_li', '李雷', '13900001111');
  const uWang = ensureUser('demo_wang', '王小明', '13700002222');
  const uZhao = ensureUser('demo_zhao', '赵倩', '13600003333');
  const uChen = ensureUser('demo_chen', '陈默', '13500004444');
  const uDemo = ensureUser('demo_user', '演示用户', '13800000000');

  // 演示报名：自定义报名字段（3 个活动都配置了 行业/公司/话题）
  const demoCustom = { industry: '互联网/软件', company: '演示科技公司', drink: '无酒', topic: '想听大模型落地的真实案例与踩坑' };

  // 活动1：标准 已支付 + 已签到
  const r1 = registrations.createRegistration(ev1.id, uLi, { registrationOptionId: ev1Std.id, remark: '第一次来', customFields: demoCustom });
  registrations.payRegistration(r1.id);
  checkin.performCheckin(r1.id, 'QR', '现场小王', null);
  // 活动1：早鸟 已支付（未签到）
  const r2 = registrations.createRegistration(ev1.id, uWang, { registrationOptionId: ev1Early.id, customFields: demoCustom });
  registrations.payRegistration(r2.id);
  // 活动1：标准 待支付
  const r3 = registrations.createRegistration(ev1.id, uZhao, { registrationOptionId: ev1Std.id, remark: '需要发票', customFields: demoCustom });
  void r3;
  // 活动1：早鸟 已支付后退款
  const r4 = registrations.createRegistration(ev1.id, uChen, { registrationOptionId: ev1Early.id, customFields: demoCustom });
  registrations.payRegistration(r4.id);
  registrations.refundRegistration(r4.id, '临时有事');
  // 活动2：标准 已支付（未签到）
  const r5 = registrations.createRegistration(ev2.id, uDemo, { registrationOptionId: ev2Std.id, customFields: demoCustom });
  registrations.payRegistration(r5.id);
  // 活动2：早鸟 已支付 + 已签到
  const r6 = registrations.createRegistration(ev2.id, uLi, { registrationOptionId: ev2Early.id, customFields: demoCustom });
  registrations.payRegistration(r6.id);
  checkin.performCheckin(r6.id, 'PHONE_LAST4', '现场小李', null);
  // 活动1：双人同行票 已支付 + 只核销第 1 码（1/2 码演示）
  const r7 = registrations.createRegistration(ev1.id, uWang, { registrationOptionId: ev1Double.id, remark: '带朋友', customFields: demoCustom });
  registrations.payRegistration(r7.id);
  checkin.performCheckin(r7.id, 'QR', '现场小王', null, 1);
  // 活动1：受邀专享票 已支付（需购买邀请码，演示门槛校验）
  const r8 = registrations.createRegistration(ev1.id, uZhao, { registrationOptionId: ev1Invite.id, gateCode: 'CLINK-2026', customFields: demoCustom });
  registrations.payRegistration(r8.id);
  // 活动3：候补登记 免费（免支付，仅统计候补人数）
  const r9 = registrations.createRegistration(ev3.id, uChen, { registrationOptionId: ev3Wait.id, remark: '想参加，满了就候补', customFields: demoCustom });

  // 评价（C⑨）：已核销用户给活动打分（详情页展示）
  try {
    reviews.upsertReview(uLi, { eventId: ev1.id, rating: 5, comment: '干货密度很高，现场动手环节特别值，一边喝酒一边学 AI 的体验很独特' });
    reviews.upsertReview(uLi, { eventId: ev2.id, rating: 4, comment: 'Claude Code 实操讲得很细，建议带电脑来跟着做' });
    reviews.upsertReview(uWang, { eventId: ev1.id, rating: 5, comment: '嘉宾很真诚，问题都能现场解答，期待下一期' });
  } catch (e) {
    console.log('（跳过评价种子：', (e as Error).message, '）');
  }

  // 分享内容（「分享」tab）：现场视频 / 网课 / 知识文字 各一条示例
  try {
    shares.createShare({
      type: 'VIDEO',
      title: '现场实录｜《赛博算命背后》嘉宾对谈（第 75 期）',
      summary: '活动当晚嘉宾圆桌实录：大模型如何理解复杂社会？完整 40 分钟。',
      coverImage: '/uploads/img_1789112075114_ybbia3.jpg',
      videoUrl: 'https://www.w3schools.com/html/mov_bbb.mp4',
      sortOrder: 1,
    });
    shares.createShare({
      type: 'COURSE',
      title: '网课｜从 Codex 出发：AI 时代的底层思维（第 1 讲）',
      summary: '1 小时录播课：任务拆解、上下文工程、把 AI 当同事而不是工具。',
      coverImage: '/uploads/img_1789112075114_ybbia3.jpg',
      videoUrl: 'https://www.w3schools.com/html/mov_bbb.mp4',
      sortOrder: 2,
    });
    shares.createShare({
      type: 'TEXT',
      title: '文字分享｜活动组织的 5 个反直觉经验',
      summary: '办了几十场线下活动后，最想对新手组织者说的 5 句话。',
      content: '1. 报名截止不是结束，是开始——提前 24h 提醒能挽回一半以上的流失。\n2. 候补名单是宝藏：每次放鸽子都能从候补里补上人。\n3. 双人票的核销码一定要分开扫，否则现场排队。\n4. 退款规则写清楚比退款本身更重要。\n5. 复盘别只看人数，看"第二次来的人"有多少。',
      sortOrder: 3,
    });
  } catch (e) {
    console.log('（跳过分享种子：', (e as Error).message, '）');
  }

  console.log('Seed 完成：');
  console.log(`  活动1「${ev1.title}」+ 5 报名类型（早鸟¥88 / 标准¥118 / 双人¥188 / 受邀¥128·码CLINK-2026 / 候补免费，capacity=${ev1.capacity}）`);
  console.log(`  活动2「${ev2.title}」+ 3 报名类型（早鸟¥68 / 标准¥88 / 候补免费，capacity=${ev2.capacity}）`);
  console.log(`  活动3「${ev3.title}」+ 3 报名类型（标准¥118 / 贵宾¥188 / 候补免费，capacity=${ev3.capacity}）`);
  console.log('  演示报名 9 条：单人/双人(1/2码)/邀请(门槛码)/候补(免费) 全票种 + 已支付/待支付/已退款/已签到 覆盖。');
  console.log('  管理端账号：admin / admin123（仅 development）。');
}

main();
