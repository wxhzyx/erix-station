import { AdminError } from './admin.js';

export function validateDeliveryTarget(input = { type: 'web' }) {
  const bad = () => { throw new AdminError('invalid_delivery_target', '请选择交付类型，并配置桌面版构建命令、工作目录和产物文件'); };
  if (!input || !['web', 'desktop'].includes(input.type)) return bad();
  if (input.type === 'web') return { type: 'web' };
  const b = input.build;
  const relative = value => typeof value === 'string' && value.length <= 240
    && !/[\\:\x00-\x1f\x7f]/.test(value)
    && value.split('/').every(p => p && p !== '..' && p !== '.' && !p.startsWith('-'));
  if (!b || typeof b.command !== 'string' || !b.command.trim() || b.command.length > 8000
    || (b.directory !== '.' && !relative(b.directory)) || !relative(b.output)
    || !/\.(zip|exe|msi|dmg|AppImage|deb|apk)$/i.test(b.output)
    || !Number.isInteger(b.timeout_seconds) || b.timeout_seconds < 30 || b.timeout_seconds > 1800) return bad();
  return { type: 'desktop', build: { command: b.command.trim(), directory: b.directory,
    output: b.output, timeout_seconds: b.timeout_seconds } };
}
