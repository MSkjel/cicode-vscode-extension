// webpack.config.js
//@ts-check
"use strict";

const path = require("path");

/** @type {import('webpack').Configuration} */
module.exports = {
  target: "node", // VS Code runs in Node
  mode: "production",
  entry: "./src/extension.ts", // <-- point to TS entry
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "extension.js",
    libraryTarget: "commonjs2",
    devtoolModuleFilenameTemplate: "../[resource-path]",
  },
  externals: {
    // VS Code API is provided at runtime; don't bundle it
    vscode: "commonjs vscode",
  },
  resolve: {
    extensions: [".ts", ".js"], // <-- resolve TS too
  },
  module: {
    rules: [{ test: /\.ts$/, exclude: /node_modules/, use: "ts-loader" }],
  },
  devtool: "source-map",
  node: { __dirname: false, __filename: false },
};
