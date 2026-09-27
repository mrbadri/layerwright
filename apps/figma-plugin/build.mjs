import * as esbuild from "esbuild";
import { mkdirSync, copyFileSync } from "node:fs";
const watch = process.argv.includes("--watch");
mkdirSync("dist", { recursive: true });
copyFileSync("src/ui.html", "dist/ui.html");
const ctx = await esbuild.context({ entryPoints: ["src/code.ts"], bundle: true, outfile: "dist/code.js", target: "es2017", format: "iife", logLevel: "info" });
if (watch) await ctx.watch(); else { await ctx.rebuild(); await ctx.dispose(); }
