/**
 * Small XML helpers for the machine-generated documents inside flat packages
 * (PackageInfo, Distribution, xar table of contents). Not a general-purpose
 * XML library.
 */

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  text: string;
}

function unescapeXml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos|#x?[0-9a-fA-F]+);/g, (_, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        return String.fromCodePoint(
          entity[1] === 'x' || entity[1] === 'X'
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10),
        );
    }
  });
}

/**
 * Parse a well-formed XML document into a simple element tree. Supports what
 * appears in xar TOCs and PackageInfo files: elements, attributes, character
 * data, comments, processing instructions and doctypes (both skipped).
 */
export function parseXml(input: string): XmlElement {
  let pos = 0;
  const len = input.length;

  const error = (message: string): never => {
    throw new Error(`XML parse error at offset ${pos}: ${message}`);
  };

  const skipMisc = () => {
    for (;;) {
      while (pos < len && /\s/.test(input[pos])) pos++;
      if (input.startsWith('<?', pos)) {
        const end = input.indexOf('?>', pos);
        if (end === -1) error('unterminated processing instruction');
        pos = end + 2;
      } else if (input.startsWith('<!--', pos)) {
        const end = input.indexOf('-->', pos);
        if (end === -1) error('unterminated comment');
        pos = end + 3;
      } else if (input.startsWith('<!', pos)) {
        const end = input.indexOf('>', pos);
        if (end === -1) error('unterminated declaration');
        pos = end + 1;
      } else {
        return;
      }
    }
  };

  const parseElement = (): XmlElement => {
    if (input[pos] !== '<') error('expected element');
    pos++;
    const nameMatch = /^[^\s/>]+/.exec(input.slice(pos));
    if (!nameMatch) error('expected element name');
    const name = nameMatch![0];
    pos += name.length;
    const element: XmlElement = { name, attributes: {}, children: [], text: '' };

    for (;;) {
      while (pos < len && /\s/.test(input[pos])) pos++;
      if (input.startsWith('/>', pos)) {
        pos += 2;
        return element;
      }
      if (input[pos] === '>') {
        pos++;
        break;
      }
      const attrMatch = /^([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/.exec(input.slice(pos));
      if (!attrMatch) error('expected attribute');
      element.attributes[attrMatch![1]] = unescapeXml(attrMatch![3] ?? attrMatch![4] ?? '');
      pos += attrMatch![0].length;
    }

    // Content
    for (;;) {
      if (pos >= len) error(`unterminated element <${name}>`);
      if (input.startsWith('</', pos)) {
        const end = input.indexOf('>', pos);
        if (end === -1) error('unterminated closing tag');
        const closing = input.slice(pos + 2, end).trim();
        if (closing !== name) error(`mismatched closing tag ${closing}, expected ${name}`);
        pos = end + 1;
        return element;
      }
      if (input.startsWith('<!--', pos)) {
        const end = input.indexOf('-->', pos);
        if (end === -1) error('unterminated comment');
        pos = end + 3;
        continue;
      }
      if (input[pos] === '<') {
        element.children.push(parseElement());
        continue;
      }
      const next = input.indexOf('<', pos);
      const textEnd = next === -1 ? len : next;
      element.text += unescapeXml(input.slice(pos, textEnd));
      pos = textEnd;
    }
  };

  skipMisc();
  const rootElement = parseElement();
  return rootElement;
}

export function findChild(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((child) => child.name === name);
}

export function findChildren(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((child) => child.name === name);
}
