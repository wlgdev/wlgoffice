export default {
  debug: (...args: any[]) => console.debug(`${new Date().toISOString()} [DEBUG]`, ...args),
  log: (...args: any[]) => console.log(`${new Date().toISOString()} [LOG]`, ...args),
  info: (...args: any[]) => console.log(`${new Date().toISOString()} [INFO]`, ...args),
  warn: (...args: any[]) => console.warn(`${new Date().toISOString()} [WARN]`, ...args),
  error: (...args: any[]) => console.error(`${new Date().toISOString()} [ERROR]`, ...args),
};
