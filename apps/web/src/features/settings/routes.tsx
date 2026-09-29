// All settings routes in one place (App.tsx only mounts `{settingsRoutes}`): overviews, subpages, Info & Hilfe, the
// shared Nyx profile draft around all Nyx pages and the redirect of old paths (`/einstellungen/haiku`,
// `/einstellungen/ideen-links` – from `aliases` in the register).
import { Navigate, Outlet, Route, useLocation } from "react-router";
import { InfoPage } from "./info/InfoPage";
import { NyxProfileProvider } from "./nyx/NyxProfileContext";
import { ALL_SECTIONS, INFO_SETTINGS_PATH, NYX_SETTINGS_PATH, SETTINGS_PATH } from "./sections";
import { SettingsOverview } from "./SettingsOverview";
import { SettingsSubpage } from "./SettingsSubpage";

function NyxSettingsLayout() {
  return (
    <NyxProfileProvider>
      <Outlet />
    </NyxProfileProvider>
  );
}

/** Old path → new subpage; an anchor is kept. */
function AliasRedirect({ to }: { to: string }) {
  const { hash } = useLocation();
  return <Navigate to={`${to}${hash}`} replace />;
}

export const settingsRoutes = (
  <>
    <Route path={SETTINGS_PATH} element={<SettingsOverview scope="general" />} />
    <Route path={`${SETTINGS_PATH}/:sectionId`} element={<SettingsSubpage scope="general" />} />
    <Route path={NYX_SETTINGS_PATH} element={<NyxSettingsLayout />}>
      <Route index element={<SettingsOverview scope="nyx" />} />
      <Route path=":sectionId" element={<SettingsSubpage scope="nyx" />} />
    </Route>
    <Route path={INFO_SETTINGS_PATH} element={<InfoPage />} />
    {ALL_SECTIONS.flatMap((s) => (s.aliases ?? []).map((alias) => <Route key={alias} path={alias} element={<AliasRedirect to={s.path} />} />))}
  </>
);
