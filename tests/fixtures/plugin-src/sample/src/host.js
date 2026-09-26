import { greeting } from './greeting.js';

export function activate(context) {
  context.log.info(greeting('sample'));
}
