'use strict';

var WalletCrypto = require('./wallet-crypto');
var Bitcoin = require('bitcoinjs-lib');
var API = require('./api');
var Helpers = require('./helpers');
var constants = require('./constants');
var R = require('ramda');

class Metadata {
  constructor (ecPair, encKeyBuffer, typeId) {
    // ecPair :: ECPair object - bitcoinjs-lib
    // encKeyBuffer :: Buffer (nullable = no encrypted save)
    // TypeId :: Int (nullable = default -1)
    this.VERSION = 1;
    this._typeId = typeId || -1;
    this._magicHash = null;
    this._address = ecPair.getAddress();
    this._signKey = ecPair;
    this._encKeyBuffer = encKeyBuffer;
    this._sequence = Promise.resolve();
  }

  get existsOnServer () {
    return Boolean(this._magicHash);
  }
}

Metadata.PURPOSE = 'info.blockchain.metadata';
// network
Metadata.request = function (method, endpoint, data) {
  const url = API.API_ROOT_URL + 'metadata/' + endpoint;
  let options = {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'omit'
  };
  if (method !== 'GET') {
    options.body = JSON.stringify(data);
  }
  options.method = method;
  const handleNetworkError = (e) =>
    Promise.reject({ error: 'METADATA_CONNECT_ERROR', message: e });

  const checkStatus = (response) => {
    if (response.status >= 200 && response.status < 300) {
      return response.json();
    } else if (method === 'GET' && response.status === 404) {
      return null;
    } else {
      return response.text().then(Promise.reject.bind(Promise));
    }
  };
  return fetch(url, options)
    .catch(handleNetworkError)
    .then(checkStatus);
};

Metadata.GET = function (e, d) { return Metadata.request('GET', e, d); };
Metadata.PUT = function (e, d) { return Metadata.request('PUT', e, d); };
Metadata.read = (address) => Metadata.request('GET', address)
                                      .then(Metadata.extractResponse(null));

// //////////////////////////////////////////////////////////////////////////////
Metadata.encrypt = R.curry((key, data) => WalletCrypto.encryptDataWithKey(data, key));
Metadata.decrypt = R.curry((key, data) => WalletCrypto.decryptDataWithKey(data, key));
Metadata.B64ToBuffer = (base64) => Buffer.from(base64, 'base64');
Metadata.BufferToB64 = (buff) => buff.toString('base64');
Metadata.StringToBuffer = (base64) => Buffer.from(base64);
Metadata.BufferToString = (buff) => buff.toString();

// Metadata.message :: Buffer -> Buffer -> Base64String
Metadata.message = R.curry(
  function (payload, prevMagic) {
    if (prevMagic) {
      const hash = WalletCrypto.sha256(payload);
      const buff = Buffer.concat([prevMagic, hash]);
      return buff.toString('base64');
    } else {
      return payload.toString('base64');
    }
  }
);

// Metadata.magic :: Buffer -> Buffer -> Buffer
Metadata.magic = R.curry(
  function (payload, prevMagic) {
    const msg = this.message(payload, prevMagic);
    return Bitcoin.message.magicHash(msg, constants.getNetwork());
  }
);

Metadata.verify = (address, signature, hash) =>
  Bitcoin.message.verify(address, signature, hash);

// Metadata.sign :: keyPair -> msg -> Buffer
Metadata.sign = (keyPair, msg) => Bitcoin.message.sign(keyPair, msg, Bitcoin.networks.bitcoin);

// Metadata.computeSignature :: keypair -> buffer -> buffer -> base64
Metadata.computeSignature = (key, payloadBuff, magicHash) =>
  Metadata.sign(key, Metadata.message(payloadBuff, magicHash));

Metadata.verifyResponse = R.curry((address, res) => {
  if (res === null) return res;
  const M = Metadata;
  const sB = res.signature ? Buffer.from(res.signature, 'base64') : undefined;
  const pB = res.payload ? Buffer.from(res.payload, 'base64') : undefined;
  const mB = res.prev_magic_hash ? Buffer.from(res.prev_magic_hash, 'hex') : undefined;
  const verified = Metadata.verify(address, sB, M.message(pB, mB));
  if (!verified) throw new Error('METADATA_SIGNATURE_VERIFICATION_ERROR');
  return R.assoc('compute_new_magic_hash', M.magic(pB, mB), res);
});

Metadata.extractResponse = R.curry((encKey, res) => {
  const M = Metadata;
  if (res === null) {
    return res;
  } else {
    return encKey
      ? R.compose(JSON.parse, M.decrypt(encKey), R.prop('payload'))(res)
      : R.compose(JSON.parse, M.BufferToString, M.B64ToBuffer, R.prop('payload'))(res);
  }
});

Metadata.toImmutable = R.compose(Object.freeze, JSON.parse, JSON.stringify);

Metadata.prototype.create = function (payload) {
  const M = Metadata;
  payload = M.toImmutable(payload);
  return this.next(() => {
    const encPayloadBuffer = this._encKeyBuffer
      ? R.compose(M.B64ToBuffer, M.encrypt(this._encKeyBuffer), JSON.stringify)(payload)
      : R.compose(M.StringToBuffer, JSON.stringify)(payload);
    const signatureBuffer = M.computeSignature(this._signKey, encPayloadBuffer, this._magicHash);
    const body = {
      'version': this.VERSION,
      'payload': encPayloadBuffer.toString('base64'),
      'signature': signatureBuffer.toString('base64'),
      'prev_magic_hash': this._magicHash ? this._magicHash.toString('hex') : null,
      'type_id': this._typeId
    };
    return M.PUT(this._address, body).then(
      (response) => {
        this._value = payload;
        this._magicHash = M.magic(encPayloadBuffer, this._magicHash);
        return payload;
      }
    );
  });
};

Metadata.prototype.update = function (payload) {
  if (JSON.stringify(payload) === JSON.stringify(this._value)) {
    return this.next(() => Promise.resolve(Metadata.toImmutable(payload)));
  } else {
    return this.create(payload);
  }
};

Metadata.prototype.fetch = function () {
  return this.next(() => {
    const M = Metadata;
    const saveMagicHash = (res) => {
      if (res === null) return res;
      this._magicHash = R.prop('compute_new_magic_hash', res);
      return res;
    };
    const saveValue = (res) => {
      if (res === null) return res;
      this._value = Metadata.toImmutable(res);
      return res;
    };
    return M.GET(this._address).then(M.verifyResponse(this._address))
                               .then(saveMagicHash)
                               .then(M.extractResponse(this._encKeyBuffer))
                               .then(saveValue)
                               .catch((e) => Promise.reject('METADATA_FETCH_FAILED'));
  });
};

Metadata.prototype.next = function (f) {
  var nextInSeq = this._sequence.then(f);
  this._sequence = nextInSeq.then(Helpers.noop, Helpers.noop);
  return nextInSeq;
};

// CONSTRUCTORS
// used to restore metadata from purpose xpriv (second password)
Metadata.fromMetadataHDNode = function (metadataHDNode, typeId) {
  // Payload types:
  // 0: reserved (guid)
  // 1: reserved
  // 2: whats-new
  // 3: buy-sell
  // 4: contacts
  const payloadTypeNode = metadataHDNode.deriveHardened(typeId);
  // purpose' / type' / 0' : https://meta.blockchain.info/{address}
  //                       signature used to authenticate
  // purpose' / type' / 1' : sha256(private key) used as 256 bit AES key
  const node = payloadTypeNode.deriveHardened(0);
  const privateKeyBuffer = payloadTypeNode.deriveHardened(1).keyPair.d.toBuffer();
  const encryptionKey = WalletCrypto.sha256(privateKeyBuffer);
  return new Metadata(node.keyPair, encryptionKey, typeId);
};

// used to create a new metadata entry from wallet master hd node
Metadata.fromMasterHDNode = function (masterHDNode, typeId) {
  var metadataHDNode = Metadata.masterToMetaNode(masterHDNode, Metadata.PURPOSE);
  return Metadata.fromMetadataHDNode(metadataHDNode, typeId);
};

Metadata.masterToMetaNode = function (masterHDNode, purposeString) {
  // BIP 43 purpose needs to be 31 bit or less. For lack of a BIP number
  // we take the first 31 bits of the SHA256 hash of a reverse domain.
  var hash = WalletCrypto.sha256(purposeString);
  var purpose = hash.slice(0, 4).readUInt32BE(0) & 0x7FFFFFFF; // 510742
  return masterHDNode.deriveHardened(purpose);
};

module.exports = Metadata;
