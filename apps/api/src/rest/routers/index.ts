import { OpenAPIHono } from "@hono/zod-openapi";
import { protectedMiddleware } from "../middleware";
import { inboxRouter } from "./inbox";
import oauthRouter from "./oauth";
import { teamsRouter } from "./teams";
import { usersRouter } from "./users";

const routers = new OpenAPIHono();

// Mount OAuth routes first (publicly accessible)
routers.route("/oauth", oauthRouter);

// Apply protected middleware to all subsequent routes
routers.use(...protectedMiddleware);

// Mount protected routes
routers.route("/teams", teamsRouter);
routers.route("/users", usersRouter);
routers.route("/inbox", inboxRouter);

export { routers };
