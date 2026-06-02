/// <reference types="vite/client" />

// #38：vite.config.ts 的 define 注入的全局常量（构建时替换为字面量字符串）
declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;
