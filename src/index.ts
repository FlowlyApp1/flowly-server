import express from "express";
import aiRouter from "./ai";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use("/api", aiRouter);

// Keep your existing Plaid routes etc. mounted here too.

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Flowly API running on :${PORT}`));
