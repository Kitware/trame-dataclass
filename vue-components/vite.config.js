export default {
  base: "./",
  build: {
    lib: {
      entry: "./src/main.js",
      name: "trame_dataclass",
      formats: ["umd"],
      // Explicit: in a "type": "module" package, vite would otherwise name the
      // UMD bundle `.umd.cjs`, and the Python module loads `.umd.js`.
      fileName: () => "trame_dataclass.umd.js",
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
