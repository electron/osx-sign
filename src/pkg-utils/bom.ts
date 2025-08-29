import { debugLog } from '../util.js';

/**
 * Process lsbom output to modify permissions and ownership
 * - Changes 755 to 775
 * - Changes 644 to 664
 * - Sets owner/group to root:admin (0/80 on macOS)
 */
export function setPermissionOnBom(bom: string) {
  return bom
    .split('\n')
    .map((line, index) => {
      if (!line.trim()) return line;

      // More flexible regex that captures spacing
      const regex = /^([^\t]+)(\t+)(\d+)(\s+)(\d+)\/(\d+)(.*)$/;
      const match = line.match(regex);

      if (!match) {
        debugLog('Unable to match Bom line:', line);
        throw new Error('Failed to parse Bom line, see debug logs for more information');
      }

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const [_, path, space1, mode, space2, oldUid, oldGid, rest] = match;

      // Modify permissions
      let newMode: string;
      if (index === 0) {
        newMode = '40775';
      } else if (mode.endsWith('755')) {
        newMode = mode.slice(0, -3) + '775';
      } else if (mode.endsWith('644')) {
        newMode = mode.slice(0, -3) + '664';
      } else {
        newMode = mode;
      }

      if (newMode !== mode) {
        debugLog('BOM Permission Rewrite', path, mode, newMode);
      }

      if (oldUid !== '0' || oldGid !== '0') {
        throw new Error('Invalid uid/gid, something went wrong');
      }

      // Set to root:admin
      const uid = '0';
      const gid = '80'; // admin group on macOS

      return `${path}${space1}${newMode}${space2}${uid}/${gid}${rest}`;
    })
    .join('\n');
}
