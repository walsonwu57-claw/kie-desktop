import { Outlet, useLocation } from "react-router-dom";
import { BottomNavigation } from "./BottomNavigation";
import { MobileHeader } from "./MobileHeader";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useApiKeyStore } from "@/stores/apiKeyStore";
import { Loader2 } from "lucide-react";
import { WelcomePage } from "@/pages/WelcomePage";

export function MobileLayout() {
  const location = useLocation();
  const { isLoading: isLoadingApiKey, isValidated } = useApiKeyStore();

  // Pages that don't require an API key
  const publicPaths = ["/", "/settings", "/templates"];
  const isPublicPage = publicPaths.some(
    (path) =>
      location.pathname === path || location.pathname.startsWith(path + "/"),
  );

  if (isLoadingApiKey) {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const requiresLogin = !isValidated && !isPublicPage;

  return (
    <TooltipProvider>
      <div className="flex flex-col h-[100dvh] bg-background">
        <MobileHeader />

        <main className="flex-1 overflow-hidden pb-14">
          {requiresLogin ? (
            <div className="h-full overflow-auto">
              <WelcomePage />
            </div>
          ) : (
            <div className="h-full overflow-auto">
              <Outlet />
            </div>
          )}
        </main>

        <BottomNavigation isValidated={isValidated} />

        <Toaster />
      </div>
    </TooltipProvider>
  );
}
