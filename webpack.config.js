const path = require("path");

/** @type {import('webpack').Configuration} */
module.exports = {
  target: "node",
  mode: "production",
  entry: "./src/extension.ts",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "extension.js",
    libraryTarget: "commonjs2",
    devtoolModuleFilenameTemplate: "../[resource-path]",
  },
  externals: {
    vscode: "commonjs vscode",
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
  module: {
    rules: [{ test: /\.ts$/, exclude: /node_modules/, use: "ts-loader" }],
  },
  devtool: "source-map",
  node: { __dirname: false, __filename: false },
};
