import react from "@vitejs/plugin-react";

export default {
  base: "./",
  plugins: [react()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    lib: {
      entry: "src/index.js",
      name: "TrameDataclass",
      formats: ["umd"],
      fileName: () => "trame_dataclass_react.umd.js",
    },
    // Own output directory (not vue-components' `module/serve`): the two
    // component packages are built independently, each with its own
    // `--emptyOutDir`, so sharing a directory would let either build wipe
    // out the other's bundle.
    outDir: "../src/trame_dataclass/module/serve-react",
    assetsDir: ".",
    rollupOptions: {
      // Use the single React instance exposed by the trame react client
      // (window.React / window.ReactDOM, see main.jsx in trame-client).
      external: ["react", "react-dom"],
      output: {
        globals: {
          react: "React",
          "react-dom": "ReactDOM",
        },
      },
    },
  },
};
