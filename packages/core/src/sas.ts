/**
 * Verification words (docs/UX.md § Send: Approve). Both peers derive the same four
 * words from the session key material, so they only match when the two screens are
 * in the same session: a stranger who opened a leaked link sees different words (or none).
 */
import type { Bytes } from './bytes.ts';
import { concat } from './bytes.ts';
import { hkdf } from './keys.ts';

/** 256 short, distinct, easy-to-say English words: one byte each. */
export const SAS_WORDS: readonly string[] = (
  'acid acorn actor adult agent alarm album alien amber angle apple april arena arrow atlas audio ' +
  'award bacon badge baker bamboo banjo barn basil beach beard berry bike bingo birch blade blank ' +
  'blaze bloom board boat bonus book brain brave bread brick broom brush cabin cable cactus camel ' +
  'candy canoe cargo carpet cedar chalk charm chess chief cider cliff clock cloud coach cobra cocoa ' +
  'comet coral cotton cowboy crane crown cube curry daisy dance delta denim depot desert diary dingo ' +
  'disco dock dolphin donut dragon drum eagle earth easel echo eclipse elbow elder ember engine ' +
  'falcon fancy ferry fever field flame flute focus forest fossil fox frost fudge galaxy garden gecko ' +
  'ghost giant ginger glacier globe goose grape gravy guitar habit hammer harbor hazel heron hippo ' +
  'honey hotel husky igloo index iris island ivory jacket jaguar jazz jelly jewel judge juice jungle ' +
  'kayak kettle kiwi koala ladder lagoon lake lemon lens lily lime lion llama lobby locket lotus ' +
  'lunar magnet mango maple marble medal melon meteor mint mirror model monkey moose motor mural ' +
  'nectar needle noble noodle north oasis ocean olive omega onion opera orbit otter owl oyster paddle ' +
  'panda paper parrot pasta peach pearl pebble pepper piano pilot pixel planet plum polar pony potato ' +
  'prism pumpkin puzzle quartz quill rabbit radar radio raven razor rhino ribbon river robin rocket ' +
  'rodeo ruby saddle salad salmon satin scarf school shadow shark shell silver sketch slate ' +
  'sonic spice spider spring squid stamp storm sugar summit sunset swan tango tea tennis thunder tiger ' +
  'toast tomato topaz torch tulip turtle'
).split(' ');

export async function verificationWords(
  sessionIkm: CryptoKey,
  nonceS: Bytes,
  nonceR: Bytes,
): Promise<string[]> {
  const bytes = await hkdf(sessionIkm, concat(nonceS, nonceR), 'sas', 4);
  return Array.from(bytes, (b) => SAS_WORDS[b] ?? '?');
}
