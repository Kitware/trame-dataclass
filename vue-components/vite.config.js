export default {
  base: "./",
  build: {
    lib: {
      entry: "./src/main.js",
      name: "trame_dataclass",
      formats: ["umd"],
      fileName: "trame_dataclass",
    },
    rollupOptions: {
      external: ["vue"],
      output: {
        globals: {
          vue: "Vue",
        },
      },
    },
    outDir: "../src/trame_dataclass/module/serve",
    assetsDir: ".",
  },
};
