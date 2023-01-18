import { sign, signApp } from './sign';
import { flat, buildPkg } from './flat';
import type { SignOptions } from './types';

// TODO: Remove and leave only proper named exports, but for non-breaking change reasons
// we need to keep this weirdness for now
module.exports = sign;
module.exports.sign = sign;
module.exports.signAsync = signApp;
module.exports.signApp = signApp;
module.exports.flat = flat;
module.exports.flatAsync = buildPkg;
module.exports.buildPkg = buildPkg;

export { sign, flat, signApp as signAsync, signApp, buildPkg as flatAsync, buildPkg };
export type { SignOptions };
