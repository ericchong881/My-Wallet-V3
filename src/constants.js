
var Bitcoin = require('bitcoinjs-lib');

module.exports = {
  NETWORK: 'bitcoin',
  getNetwork: function () {
    return Bitcoin.networks[this.NETWORK];
  },
  APP_NAME: 'javascript_web',
  APP_VERSION: '3.0'
};
