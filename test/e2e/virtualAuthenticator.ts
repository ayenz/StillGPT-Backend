import { createHash, createSign, generateKeyPairSync, type KeyObject, randomBytes } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

const b64u = (b: Uint8Array | Buffer | string) => Buffer.from(b).toString('base64url');
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();

/** AAGUID of iCloud Keychain, so new passkeys get a recognisable provider name. */
export const ICLOUD_AAGUID = 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd';

interface Credential {
  id: Buffer;
  key: KeyObject;
  rpId: string;
  userHandle: Buffer;
  counter: number;
}

/**
 * A software platform authenticator (ES256, "none" attestation) producing real WebAuthn JSON, the same shape
 * @simplewebauthn/browser hands to the server. Lets e2e tests run the full ceremony against the real verifier.
 */
export class VirtualAuthenticator {
  readonly credentials: Credential[] = [];

  constructor(private readonly aaguid = ICLOUD_AAGUID) {}

  /** navigator.credentials.create() */
  create(options: any, origin: string, o: { userVerified?: boolean } = {}) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    );
    const id = randomBytes(16);
    const rpId: string = options.rp.id;
    const cred: Credential = { id, key: privateKey, rpId, userHandle: Buffer.from(options.user.id, 'base64url'), counter: 0 };
    this.credentials.push(cred);

    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(id.length);
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([this.flags(o.userVerified) | 0x40]), // + AT (attested credential data)
      Buffer.alloc(4), // counter 0
      Buffer.from(this.aaguid.replace(/-/g, ''), 'hex'),
      idLen,
      id,
      Buffer.from(cose),
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]) as never,
    );
    const clientDataJSON = JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false });
    return {
      id: b64u(id),
      rawId: b64u(id),
      type: 'public-key' as const,
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal', 'hybrid'] },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** navigator.credentials.get() with the first (or a given) credential for the options' RP ID. */
  get(options: any, origin: string, o: { credential?: Credential; userVerified?: boolean; userHandle?: Buffer } = {}) {
    const cred = o.credential ?? this.credentials.find((c) => c.rpId === options.rpId);
    if (!cred) throw new Error(`no credential for ${options.rpId}`);
    cred.counter += 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(cred.counter);
    const authData = Buffer.concat([sha256(options.rpId), Buffer.from([this.flags(o.userVerified)]), counter]);
    const clientDataJSON = JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false });
    const signature = createSign('SHA256').update(Buffer.concat([authData, sha256(clientDataJSON)])).sign(cred.key);
    return {
      id: b64u(cred.id),
      rawId: b64u(cred.id),
      type: 'public-key' as const,
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: b64u(o.userHandle ?? cred.userHandle) },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** UP | UV (unless disabled) | BE | BS: a synced passkey. */
  private flags(userVerified = true) {
    return 0x01 | (userVerified ? 0x04 : 0) | 0x08 | 0x10;
  }
}
