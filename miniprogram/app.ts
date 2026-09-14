// 小程序入口：启动时拉取服务端环境（§28），驱动"是否显示模拟支付"等 UI。
import { initAppConfig } from './services/appConfig';

App({
  onLaunch() {
    initAppConfig();
  },
});
