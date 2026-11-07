import { Outlet, ScrollRestoration, createBrowserRouter } from "react-router";
import { PUBLIC_BASE_PATH } from "../publicPath";
import { SignInPage, SignUpPage } from "./pages/auth";
import { ChangesPage } from "./pages/changes";
import { CourseDetailPage, CoursesPage } from "./pages/courses";
import { FilesPage } from "./pages/files";
import { CalendarPage } from "./pages/calendar";
import { NotFoundPage, RouteErrorPage } from "./pages/notFound";
import { SettingsPage } from "./pages/settings";
import { TodayPage } from "./pages/today";
import { WelcomePage } from "./pages/welcome";
import { AppShell, PublicOnly, RequireAuth } from "./shell";

function Root() {
  return (
    <>
      <ScrollRestoration />
      <Outlet />
    </>
  );
}

export const routes = [
  {
    element: <Root />,
    errorElement: <RouteErrorPage />,
    children: [
      { path: "/signin", element: <PublicOnly><SignInPage /></PublicOnly> },
      { path: "/signup", element: <PublicOnly><SignUpPage /></PublicOnly> },
      {
        element: <RequireAuth />,
        children: [
          { path: "/welcome", element: <WelcomePage /> },
          {
            path: "/",
            element: <AppShell />,
            children: [
              { index: true, element: <TodayPage /> },
              { path: "calendar", element: <CalendarPage /> },
              { path: "courses", element: <CoursesPage /> },
              { path: "courses/:courseId", element: <CourseDetailPage /> },
              { path: "changes", element: <ChangesPage /> },
              { path: "files", element: <FilesPage /> },
              { path: "settings", element: <SettingsPage /> },
              { path: "*", element: <NotFoundPage /> },
            ],
          },
        ],
      },
    ],
  },
];

export function createAppRouter() {
  return createBrowserRouter(routes, { basename: PUBLIC_BASE_PATH || undefined });
}
