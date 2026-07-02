import { readFileSync } from "fs";
import deckyPlugin from "@decky/rollup";

const { version } = JSON.parse(readFileSync("package.json", "utf-8"));

function defineVersion(v) {
  return {
    name: "define-version",
    transform(code) {
      if (!code.includes("__PLUGIN_VERSION__")) return null;
      return { code: code.replaceAll("__PLUGIN_VERSION__", JSON.stringify(v)), map: { mappings: "" } };
    },
  };
}

export default deckyPlugin({
  plugins: [defineVersion(version)],
});
