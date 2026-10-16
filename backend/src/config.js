export function getConfig(env = process.env) {
  return {
    port: Number(env.PORT || 3000),
  };
}
