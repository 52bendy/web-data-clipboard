export function getConfig(env = process.env) {
  return {
    port: Number(env.PORT || 3000),
    // 「自动提取」开关（PRD §4.2）：缺省开启，AUTO_EXTRACT=false|0 关闭；
    // 后续后台设置面板（REQ-202610-1262）接入后可覆盖该缺省值。
    autoExtract: env.AUTO_EXTRACT !== 'false' && env.AUTO_EXTRACT !== '0',
  };
}
