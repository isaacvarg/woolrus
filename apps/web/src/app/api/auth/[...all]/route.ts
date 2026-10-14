import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/server/auth";

export const GET = (request: Request) => toNextJsHandler(auth()).GET(request);
export const POST = (request: Request) => toNextJsHandler(auth()).POST(request);
