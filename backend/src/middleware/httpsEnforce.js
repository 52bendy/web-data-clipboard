export function isHttps(request, trustProxy = false) {
  const forwarded = trustProxy ? request.headers['x-forwarded-proto'] : '';
  return (
    (forwarded || '').split(',')[0].trim().toLowerCase() === 'https' ||
    (!forwarded && request.socket.encrypted === true)
  );
}
