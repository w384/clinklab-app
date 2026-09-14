// 违禁词过滤：加载 src/data/badwords.txt（来自开源词库 konsheng/Sensitive-lexicon 分类词库 + 常见辱骂词），
// 按词长分级缓存，评论/评价提交时检测，命中则拒绝。
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve(import.meta.dirname, '..', 'data', 'badwords.txt');

const WORDS: string[] = fs.existsSync(FILE)
  ? fs.readFileSync(FILE, 'utf8').split(/\r?\n/).map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 1)
  : [];

// 按长度分组（长词更具体、误伤少，优先匹配）
const BY_LEN: Record<number, string[]> = {};
for (const w of WORDS) {
  (BY_LEN[w.length] ||= []).push(w);
}
const LENS = Object.keys(BY_LEN).map(Number).sort((a, b) => b - a);

/** 命中返回命中的违禁词，否则返回 null。 */
export function findBadWord(text: string): string | null {
  const t = (text || '').toLowerCase();
  if (!t) return null;
  for (const len of LENS) {
    const group = BY_LEN[len];
    for (let i = 0; i < group.length; i++) {
      if (t.includes(group[i])) return group[i];
    }
  }
  return null;
}

export const BAD_WORD_COUNT = WORDS.length;
