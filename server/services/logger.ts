export interface ServiceLogger {
  error(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  info(context: Record<string, unknown>, message: string): void;
}

export const consoleServiceLogger: ServiceLogger = {
  error: (context, message) => console.error(message, context),
  warn: (context, message) => console.warn(message, context),
  info: (context, message) => console.info(message, context),
};

export const silentServiceLogger: ServiceLogger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
};
