import { hello } from './consumer';
import { double } from './gadget/util';

export const msg = hello();
export const nums = [1, 2, 3].map(double);