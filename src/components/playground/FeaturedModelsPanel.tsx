import { useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import type { Model } from "@/types/model";

const FEATURED_MODEL_FAMILIES: Array<{
  name: string;
  provider: string;
  description: string;
  poster: string;
  primaryVariant: string;
  tags: string[];
  ratio: "poster" | "square";
  isNew?: boolean;
}> = [
  // Curated highlights; the full catalog lives in src/data/kie-models.json
  {
    name: "Seedance 2.0",
    provider: "bytedance",
    description: "State-of-the-art video generation by ByteDance",
    poster: "/model-thumbs/seedance-t2v.jpg",
    primaryVariant: "bytedance/seedance-2",
    tags: ["Video"],
    ratio: "poster" as const,
  },
  {
    name: "Nano Banana 2",
    provider: "google",
    description: "Google's state-of-the-art image generation model",
    poster: "/model-thumbs/nano-banana-2.jpg",
    primaryVariant: "nano-banana-2",
    tags: ["Image"],
    ratio: "poster" as const,
  },
];

const TAG_COLORS = [
  "text-sky-200/90 bg-sky-400/15",
  "text-violet-200/90 bg-violet-400/15",
  "text-emerald-200/90 bg-emerald-400/15",
  "text-rose-200/90 bg-rose-400/15",
  "text-amber-200/90 bg-amber-400/15",
];

interface FeaturedModelsPanelProps {
  onSelectFeatured: (primaryVariant: string) => void;
  models: Model[];
  /** Mobile layout: 2-col grids instead of 3/4 */
  mobile?: boolean;
}

function PosterCard({
  family,
  price,
  onClick,
  className,
}: {
  family: (typeof FEATURED_MODEL_FAMILIES)[number];
  price: number | undefined;
  onClick: () => void;
  className?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div
      className={`relative rounded-xl overflow-hidden bg-muted cursor-pointer group ${className ?? ""}`}
      onClick={onClick}
    >
      {!loaded && <div className="absolute inset-0 animate-pulse bg-muted" />}
      <img
        src={family.poster}
        alt={family.name}
        className={`w-full h-full object-cover group-hover:scale-105 transition-all duration-500 ${loaded ? "opacity-100" : "opacity-0"}`}
        loading="lazy"
        onLoad={() => setLoaded(true)}
      />
      <div className="absolute inset-x-0 bottom-0 h-[60%] bg-gradient-to-t from-black/80 via-black/30 to-transparent" />
      {family.isNew && (
        <Badge className="absolute top-2 left-2 bg-primary text-primary-foreground text-[9px] px-1.5 py-0 font-bold leading-4">
          NEW
        </Badge>
      )}
      <div className="absolute bottom-2 left-2.5 right-2.5">
        <p className="text-[9px] text-white/60 uppercase tracking-wider leading-none">
          {family.provider}
        </p>
        <h4 className="text-[13px] font-bold text-white leading-tight line-clamp-1 mt-1 drop-shadow-sm">
          {family.name}
        </h4>
        {family.description && (
          <p className="text-[10px] text-white/70 leading-snug line-clamp-1 mt-0.5">
            {family.description}
          </p>
        )}
        <div className="flex items-center flex-wrap gap-1 mt-1.5">
          {family.tags.map((tag, i) => (
            <span
              key={tag}
              className={`text-[8px] rounded-full px-1.5 py-[2px] leading-none ${TAG_COLORS[i % TAG_COLORS.length]}`}
            >
              {tag}
            </span>
          ))}
          {price !== undefined && (
            <span className="text-[8px] rounded-full px-1.5 py-[2px] leading-none text-white/90 bg-white/20 ml-auto">
              ${price.toFixed(3)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function FeaturedModelsPanel({
  onSelectFeatured,
  models,
  mobile,
}: FeaturedModelsPanelProps) {
  const getPrice = (modelId: string) => {
    const model = models.find((m) => m.model_id === modelId);
    return model?.base_price;
  };

  const posters = FEATURED_MODEL_FAMILIES.filter((f) => f.ratio === "poster");
  const squares = FEATURED_MODEL_FAMILIES.filter((f) => f.ratio === "square");

  const card = (
    family: (typeof FEATURED_MODEL_FAMILIES)[number],
    cls?: string,
  ) => (
    <PosterCard
      key={family.primaryVariant}
      family={family}
      price={getPrice(family.primaryVariant)}
      onClick={() => onSelectFeatured(family.primaryVariant)}
      className={cls}
    />
  );

  return (
    <ScrollArea className="flex-1">
      <div className="p-3 space-y-3">
        {/* Header */}
        <div className="pb-1 animate-in fade-in slide-in-from-bottom-2 duration-300 fill-mode-both">
          <h3 className="text-2xl font-bold tracking-tight text-foreground">
            Featured Models
          </h3>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            Hand-picked models for image generation, video creation, and
            animation. From photorealistic portraits to cinematic motion —
            explore what's trending and start creating in seconds.
          </p>
        </div>

        {/* Top row: poster cards (3:4) — 2 cols on mobile, 3 on desktop */}
        <div
          className={
            mobile
              ? "grid grid-cols-2 gap-2"
              : "grid grid-cols-3 gap-2 animate-in fade-in slide-in-from-bottom-2 duration-300 fill-mode-both"
          }
          style={mobile ? undefined : { animationDelay: "80ms" }}
        >
          {posters.map((f) => card(f, "aspect-[3/4]"))}
        </div>

        {/* Bottom row: square cards (1:1) — 2 cols on mobile, 4 on desktop */}
        <div
          className={
            mobile
              ? "grid grid-cols-2 gap-2"
              : "grid grid-cols-4 gap-2 animate-in fade-in slide-in-from-bottom-2 duration-300 fill-mode-both"
          }
          style={mobile ? undefined : { animationDelay: "160ms" }}
        >
          {squares.map((f) => card(f, "aspect-square"))}
        </div>
      </div>
    </ScrollArea>
  );
}
