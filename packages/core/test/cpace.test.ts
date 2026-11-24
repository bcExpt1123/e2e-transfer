/** Test vectors from draft-irtf-cfrg-cpace-21, Appendix B.3 (ristretto255 + SHA-512) and §A.1. */
import { describe, expect, it } from 'vitest';
import { fromHex, toHex, utf8 } from '../src/bytes.ts';
import {
  CPACE_DSI,
  calculateGenerator,
  generatorString,
  IDENTITY,
  iskFromTranscript,
  lvCat,
  prependLen,
  sampleScalar,
  scalarFromBytes,
  scalarMult,
  scalarMultVfy,
  sidOutput,
  transcriptIr,
  transcriptOc,
} from '../src/code/cpace.ts';

const h = (s: string) => fromHex(s.replace(/\s+/g, ''));

const PRS = utf8('Password');
const CI = h('0b415f696e69746961746f720b425f726573706f6e646572');
const SID = h('7e4b4791d6a8ef019b936c79fb7f2c57');
const ADa = utf8('ADa');
const ADb = utf8('ADb');
const ya = scalarFromBytes(h('da3d23700a9e5699258aef94dc060dfda5ebb61f02a5ea77fad53f4ff0976d08'));
const yb = scalarFromBytes(h('d2316b454718c35362d83d69df6320f38578ed5984651435e2949762d900b80d'));
const Ya = h('d6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0eec482b9157');
const Yb = h('3ea7e0b19560d7c0b0f5734f63b955286dfa8232b5ebe63324e2d9e7433f7258');
const K = h('80b69a8a76457ab6a4d7f887a4bf6b55a2f80ac19c333f917a05fc9887c8b40f');

describe('CPace helpers (§A.1)', () => {
  it('prepend_len and lv_cat', () => {
    expect(toHex(prependLen(new Uint8Array(0)))).toBe('00');
    expect(toHex(prependLen(utf8('1234')))).toBe('0431323334');
    expect(toHex(lvCat(utf8('1234'), utf8('5'), new Uint8Array(0), utf8('678')))).toBe(
      '043132333401350003363738',
    );
    expect(toHex(prependLen(new Uint8Array(300)).subarray(0, 2))).toBe('ac02'); // multi-byte LEB128
  });
});

describe('CPace ristretto255 vectors (§B.3)', () => {
  it('generator string, hash and generator g', async () => {
    const gs = generatorString(CPACE_DSI, PRS, CI, SID);
    expect(gs.length).toBe(170);
    expect(toHex(gs)).toBe(
      '11435061636552697374726574746f3235350850617373776f726464' +
        '00'.repeat(100) +
        '180b415f696e69746961746f720b425f726573706f6e646572107e4b4791d6a8ef019b936c79fb7f2c57',
    );
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-512', gs));
    expect(toHex(hash)).toBe(
      'da6d3ddc8802fca9058755ffd3ebde08a9c2c74945901a258482a288b6663af06bf645c93cd1c51512307199c80e84908916d983b34af77205f90851a657ee27',
    );
    const g = await calculateGenerator(PRS, CI, SID);
    expect(toHex(g.toBytes())).toBe('222b6b195fe84b1652badb6f6a3ae3d24341e7306967f0b8115b40d5698c7e56');
  });

  it('public shares, K and ISK (initiator/responder and parallel)', async () => {
    const g = await calculateGenerator(PRS, CI, SID);
    expect(scalarMult(ya, g)).toEqual(Ya);
    expect(scalarMult(yb, g)).toEqual(Yb);
    expect(scalarMultVfy(ya, Yb)).toEqual(K);
    expect(scalarMultVfy(yb, Ya)).toEqual(K);

    const ir = transcriptIr(Ya, ADa, Yb, ADb);
    expect(toHex(ir)).toBe(
      '20d6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0eec482b915703414461203ea7e0b19560d7c0b0f5734f63b955286dfa8232b5ebe63324e2d9e7433f725803414462',
    );
    expect(toHex(await iskFromTranscript(SID, K, ir))).toBe(
      'b69effbf61b51d56401c0f65601abe428de8206feaaf0e32198896dcae7b35cd2b38950a39dfd5d4a79164614c2984f7daa460b588c1e80c3fa2068af7900447',
    );
    const oc = transcriptOc(Ya, ADa, Yb, ADb);
    expect(toHex(oc).slice(0, 8)).toBe('6f6320d6'); // "oc" ‖ lv(Ya)…, as printed in §B.3.6
    expect(toHex(await iskFromTranscript(SID, K, oc))).toBe(
      '544199d71f62f8d9a1fee55727e24fe4a45844593c2b6013c4fa3969d0e5debb2244675c0b43397cbb68d342b01fc0f98fc961469a25134de9f0f813c1a57476',
    );
    expect(transcriptOc(Yb, ADb, Ya, ADa)).toEqual(oc); // order-independent
    expect(toHex(await sidOutput(ir))).toBe(
      'bb1c449b35f0ea79a65c209f329a693d475e0ce2387bed9fe4b78f60b2a27c219813fb2cfe175ef40d2222d9261e66da7d78f7c55a303b1b8611dcdfab880c47',
    );
    expect(toHex(await sidOutput(oc))).toBe(
      '10d5941d4933497fe31b9188d690b84465e2a2d158332a7267284a071a8d0876fc5c8c329dc735d59a9f8ef6623ee23924704a2f929dd631ca981227ee82fff2',
    );
  });

  it('scalar_mult_vfy: valid input and invalid inputs (§B.3.10, §B.3.11)', () => {
    const s = scalarFromBytes(h('7cd0e075fa7955ba52c02759a6c90dbbfc10e6d40aea8d283e407d88cf538a05'));
    expect(
      toHex(scalarMultVfy(s, h('2c3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c'))),
    ).toBe('7c13645fe790a468f62c39beb7388e541d8405d1ade69d1778c5fe3e7f6b600e');
    expect(scalarMultVfy(s, h('2b3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c'))).toEqual(
      IDENTITY,
    );
    expect(scalarMultVfy(s, IDENTITY)).toEqual(IDENTITY);
    expect(scalarMultVfy(s, new Uint8Array(5))).toEqual(IDENTITY);
  });

  it('samples scalars below 2^252', () => {
    for (let i = 0; i < 50; i++) {
      const s = sampleScalar();
      expect(s > 0n && s < 2n ** 252n).toBe(true);
    }
  });
});
