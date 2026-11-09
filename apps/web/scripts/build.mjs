// 工作区根目录的 .env 里 NODE_ENV=development 是给本地运行时用的，Vite 会把它读进
// import.meta.env，导致 vite build 产出 React 开发包，并且让 import.meta.env.DEV 为真。
// 构建必须显式跑在生产模式：产物更小，且 API 默认地址会走页面同源而不是写死的 3000。
process.env.NODE_ENV = "production";

const { build } = await import("vite");

await build({ mode: "production" });
