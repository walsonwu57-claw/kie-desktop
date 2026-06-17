import { useEffect } from "react";
import { Routes, Route } from "react-router-dom";
import { MobileLayout } from "@mobile/components/layout/MobileLayout";
import { WelcomePage } from "@/pages/WelcomePage";
import { SmartPlaygroundPage } from "@/pages/SmartPlaygroundPage";
import { MobileModelsPage } from "@mobile/pages/MobileModelsPage";
import { MobilePlaygroundPage } from "@mobile/pages/MobilePlaygroundPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { useApiKeyStore } from "@/stores/apiKeyStore";
import { useModelsStore } from "@/stores/modelsStore";
import { useThemeStore } from "@/stores/themeStore";

function App() {
  const { loadApiKey, isValidated } = useApiKeyStore();
  const { fetchModels } = useModelsStore();
  const { initTheme } = useThemeStore();

  useEffect(() => {
    initTheme();
    loadApiKey();
  }, [initTheme, loadApiKey]);

  useEffect(() => {
    if (isValidated) {
      fetchModels();
    }
  }, [isValidated, fetchModels]);

  return (
    <Routes>
      <Route path="/" element={<MobileLayout />}>
        <Route index element={<WelcomePage />} />
        <Route
          path="featured-models/:familyId"
          element={<SmartPlaygroundPage />}
        />
        <Route path="models" element={<MobileModelsPage />} />
        <Route path="playground" element={<MobilePlaygroundPage />} />
        <Route path="playground/*" element={<MobilePlaygroundPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}

export default App;
