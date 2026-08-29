/**
 * Route tree — code-based TanStack Router setup.
 */

import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Dashboard } from "./routes/dashboard";
import { GraphView } from "./routes/graph";
import { KnowledgeList } from "./routes/knowledge";
import { KnowledgeDetail } from "./routes/knowledge-detail";
import { Overview } from "./routes/overview";
import { PlanDetail } from "./routes/plan-detail";
import { PlansList } from "./routes/plans";
import { ProjectShell } from "./routes/project";
import { ProposalDocDetail, ProposalDocsList } from "./routes/proposal-docs";
import { RootLayout } from "./routes/root";
import { SearchPage } from "./routes/search";
import { TasksView } from "./routes/tasks";

const rootRoute = createRootRoute({ component: RootLayout });

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Dashboard,
});

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/search",
  component: SearchPage,
});

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/p/$slug",
  component: ProjectShell,
});

const overviewRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/",
  component: Overview,
});

const knowledgeRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/knowledge",
  component: KnowledgeList,
});

const knowledgeDetailRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/knowledge/$id",
  component: KnowledgeDetail,
});

const tasksRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/tasks",
  component: TasksView,
});

const plansRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/plans",
  component: PlansList,
});

const planDetailRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/plans/$id",
  component: PlanDetail,
});

const graphRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/graph",
  component: GraphView,
});

const proposalDocsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/proposal-docs",
  component: ProposalDocsList,
});

const proposalDocDetailRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: "/proposal-docs/$id",
  component: ProposalDocDetail,
});

const routeTree = rootRoute.addChildren([
  dashboardRoute,
  searchRoute,
  projectRoute.addChildren([
    overviewRoute,
    proposalDocsRoute,
    proposalDocDetailRoute,
    knowledgeRoute,
    knowledgeDetailRoute,
    tasksRoute,
    plansRoute,
    planDetailRoute,
    graphRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
