const { merge } = require('webpack-merge');
const common = require('./webpack.common.js');

module.exports = merge(common, {
  mode: 'development',
  devtool: 'inline-source-map',
  devServer: {
    liveReload: true,
    hot: true,
    open: true,
    port: 8080,
    static: ['./'],
    proxy: [
      {
        context: ['/api'],
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    ],
  },
});
