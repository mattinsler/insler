import { isDevelopment, isProduction, isTest } from 'std-env';

export type ServiceEnv = 'development' | 'test' | 'production';

export function detectEnv(): ServiceEnv {
  if (isTest) return 'test';
  if (isProduction) return 'production';
  if (isDevelopment) return 'development';
  return 'production';
}
