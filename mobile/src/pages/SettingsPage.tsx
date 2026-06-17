import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useApiKeyStore } from "@/stores/apiKeyStore";
import { apiClient } from "@/api/client";
import { useThemeStore, type Theme } from "@/stores/themeStore";
import { languages } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/hooks/useToast";
import {
  Eye,
  EyeOff,
  Loader2,
  Monitor,
  Moon,
  Sun,
  RefreshCw,
} from "lucide-react";

/**
 * Minimal mobile Settings — API key, credits, appearance, language.
 * (The desktop free-tool predownload / cache / assets-dir UI is omitted
 * since the mobile build ships no free tools.)
 */
export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const {
    apiKey,
    setApiKey,
    isValidated,
    isValidating,
    validateApiKey,
  } = useApiKeyStore();
  const { theme, setTheme } = useThemeStore();

  const [inputKey, setInputKey] = useState(apiKey);
  const [showKey, setShowKey] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const [balance, setBalance] = useState<number | null>(null);
  const [isLoadingBalance, setIsLoadingBalance] = useState(false);

  const [languagePreference, setLanguagePreference] = useState(
    () => localStorage.getItem("kie_language") || "auto",
  );

  useEffect(() => {
    setInputKey(apiKey);
  }, [apiKey]);

  const fetchBalance = useCallback(async () => {
    if (!isValidated) return;
    setIsLoadingBalance(true);
    try {
      setBalance(await apiClient.getBalance());
    } catch {
      toast({
        title: t("common.error"),
        description: t("settings.balance.refreshFailed"),
        variant: "destructive",
      });
    } finally {
      setIsLoadingBalance(false);
    }
  }, [isValidated, t]);

  useEffect(() => {
    if (isValidated) fetchBalance();
    else setBalance(null);
  }, [isValidated, fetchBalance]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await setApiKey(inputKey.trim());
      const ok = await validateApiKey();
      toast({
        title: ok ? t("common.success") : t("common.error"),
        description: ok
          ? t("settings.apiKey.saved")
          : t("settings.apiKey.invalid"),
        variant: ok ? "default" : "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  }, [inputKey, setApiKey, validateApiKey, t]);

  const handleLanguageChange = useCallback(
    (langCode: string) => {
      setLanguagePreference(langCode);
      localStorage.setItem("kie_language", langCode);
      if (langCode === "auto") {
        const browserLang = navigator.language || "en";
        const supported = ["en", "zh-CN"];
        i18n.changeLanguage(
          supported.find((l) => browserLang.startsWith(l.split("-")[0])) ||
            "en",
        );
      } else {
        i18n.changeLanguage(langCode);
      }
      toast({
        title: t("settings.language.changed"),
        description: t("settings.language.changedDesc"),
      });
    },
    [i18n, t],
  );

  return (
    <div className="p-4 space-y-6 max-w-2xl mx-auto">
      <h1 className="text-xl font-bold tracking-tight">{t("nav.settings")}</h1>

      {/* API key */}
      <Card>
        <CardHeader>
          <CardTitle>{t("settings.apiKey.title")}</CardTitle>
          <CardDescription>{t("settings.apiKey.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="apiKey">{t("settings.apiKey.label")}</Label>
            <div className="relative">
              <Input
                id="apiKey"
                type={showKey ? "text" : "password"}
                value={inputKey}
                onChange={(e) => setInputKey(e.target.value)}
                placeholder={t("settings.apiKey.placeholder")}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowKey((s) => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              >
                {showKey ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("settings.apiKey.getKey")}{" "}
              <a
                href="https://kie.ai/api-key"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary"
              >
                kie.ai/api-key
              </a>
            </p>
          </div>
          <Button onClick={handleSave} disabled={isSaving || !inputKey}>
            {isSaving || isValidating ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t("settings.apiKey.validating")}
              </>
            ) : (
              t("settings.apiKey.save")
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Credits */}
      {isValidated && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>{t("settings.balance.title")}</CardTitle>
                <CardDescription>
                  {t("settings.balance.description")}
                </CardDescription>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={fetchBalance}
                disabled={isLoadingBalance}
              >
                <RefreshCw
                  className={`h-4 w-4 ${isLoadingBalance ? "animate-spin" : ""}`}
                />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold">
                {isLoadingBalance ? (
                  <Loader2 className="h-6 w-6 animate-spin" />
                ) : balance !== null ? (
                  balance.toLocaleString()
                ) : (
                  "—"
                )}
              </span>
              {balance !== null && !isLoadingBalance && (
                <span className="text-sm text-muted-foreground">credits</span>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Appearance */}
      <Card>
        <CardHeader>
          <CardTitle>{t("settings.appearance.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>{t("settings.appearance.theme")}</Label>
            <Select
              value={theme}
              onValueChange={(v) => setTheme(v as Theme)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">
                  <span className="flex items-center gap-2">
                    <Monitor className="h-4 w-4" />
                    {t("settings.appearance.themeAuto")}
                  </span>
                </SelectItem>
                <SelectItem value="light">
                  <span className="flex items-center gap-2">
                    <Sun className="h-4 w-4" />
                    {t("settings.appearance.themeLight")}
                  </span>
                </SelectItem>
                <SelectItem value="dark">
                  <span className="flex items-center gap-2">
                    <Moon className="h-4 w-4" />
                    {t("settings.appearance.themeDark")}
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>{t("settings.language.title")}</Label>
            <Select
              value={languagePreference}
              onValueChange={handleLanguageChange}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {languages.map((lang) => (
                  <SelectItem key={lang.code} value={lang.code}>
                    {lang.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
