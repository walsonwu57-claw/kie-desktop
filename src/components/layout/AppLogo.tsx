import logoLight from "@/assets/logo-light.png";
import logoDark from "@/assets/logo-dark.png";

interface AppLogoProps {
  className?: string;
}

export function AppLogo({ className = "h-10 w-10" }: AppLogoProps) {
  return (
    <>
      <img
        src={logoLight}
        alt="Kie Desktop"
        className={`${className} block dark:hidden object-contain`}
      />
      <img
        src={logoDark}
        alt="Kie Desktop"
        className={`${className} hidden dark:block object-contain`}
      />
    </>
  );
}
