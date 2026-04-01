const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => {
  const isProd = argv.mode === 'production';

  return {
    entry: {
      'service-worker': './src/background/service-worker.ts',
      'content-script': './src/content/content-script.ts',
      'popup': './src/popup/index.tsx',
      'offscreen': './src/offscreen/offscreen.ts',
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      clean: true,
    },
    resolve: {
      extensions: ['.ts', '.tsx', '.js', '.jsx'],
      alias: {
        'react': 'preact/compat',
        'react-dom': 'preact/compat',
        'react/jsx-runtime': 'preact/jsx-runtime',
      },
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: 'ts-loader',
          exclude: /node_modules/,
        },
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader'],
        },
      ],
    },
    plugins: [
      new CopyWebpackPlugin({
        patterns: [
          { from: 'src/manifest.json', to: 'manifest.json' },
          { from: 'src/offscreen/offscreen.html', to: 'offscreen.html' },
          { from: 'public', to: '.', noErrorOnMissing: true },
          { from: 'src/assets', to: 'assets', noErrorOnMissing: true },
        ],
      }),
    ],
    devtool: isProd ? false : 'cheap-module-source-map',
    optimization: {
      minimize: isProd,
    },
  };
};
