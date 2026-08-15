import express from "express";
import cors from "cors";
import routes from "./routes/index.js";

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(routes);

export default app;
