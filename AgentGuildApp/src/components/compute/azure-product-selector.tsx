"use client";

import { useState } from "react";
import { AZURE_PRODUCTS, type AzureProductType, type SizeKey } from "@/lib/compute/types";

interface AzureProductSelectorProps {
  selectedProduct: AzureProductType;
  selectedSize: SizeKey;
  onProductChange: (product: AzureProductType) => void;
}

export function AzureProductSelector({
  selectedProduct,
  selectedSize,
  onProductChange,
}: AzureProductSelectorProps) {
  const [showComparison, setShowComparison] = useState(false);

  const currentProduct = AZURE_PRODUCTS[selectedProduct];
  const currentCost = currentProduct.pricing[selectedSize];

  return (
    <div className="space-y-4">
      {/* Product Selector */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-muted-foreground">Azure Product</label>
          <button
            type="button"
            onClick={() => setShowComparison(!showComparison)}
            className="text-xs text-primary hover:underline"
          >
            {showComparison ? "Hide" : "Compare"} products
          </button>
        </div>

        <div className="grid grid-cols-1 gap-3">
          {(Object.entries(AZURE_PRODUCTS) as [AzureProductType, typeof currentProduct][]).map(
            ([key, product]) => {
              const isSelected = selectedProduct === key;
              const cost = product.pricing[selectedSize];
              const savings = cost < currentCost ? Math.round(((currentCost - cost) / currentCost) * 100) : 0;

              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => onProductChange(key)}
                  className={`relative rounded-xl border-2 p-4 text-left transition-all duration-200 ${
                    isSelected
                      ? "border-primary bg-primary/10 shadow-sm ring-2 ring-primary/20 scale-[1.01]"
                      : "border-border hover:border-primary/40 bg-card hover:bg-muted/50"
                  }`}
                >
                  {isSelected && (
                    <div className="absolute top-3 right-3 h-2.5 w-2.5 rounded-full bg-primary" />
                  )}

                  {savings > 0 && !isSelected && (
                    <span className="absolute top-2 right-2 text-[10px] bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-full font-bold">
                      Save {savings}%
                    </span>
                  )}

                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                      <div className={`font-semibold text-sm ${isSelected ? "text-primary" : "text-foreground"}`}>
                        {product.label}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                        {product.description}
                      </p>

                      {/* Features */}
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {product.features.slice(0, 3).map((feature, idx) => (
                          <span
                            key={idx}
                            className="text-[10px] px-2 py-0.5 rounded-full bg-muted/70 text-muted-foreground font-medium"
                          >
                            {feature}
                          </span>
                        ))}
                      </div>

                      {/* Limitations */}
                      {product.limitations && product.limitations.length > 0 && (
                        <div className="mt-2 text-[10px] text-amber-500/80 flex items-center gap-1">
                          <span>⚠️</span>
                          <span>{product.limitations[0]}</span>
                        </div>
                      )}
                    </div>

                    <div className="text-right">
                      <div className={`text-lg font-bold ${isSelected ? "text-primary" : "text-foreground"}`}>
                        ${(cost / 100).toFixed(2)}
                      </div>
                      <div className="text-[10px] text-muted-foreground">/hour</div>
                    </div>
                  </div>
                </button>
              );
            }
          )}
        </div>
      </div>

      {/* Product Comparison Table */}
      {showComparison && (
        <div className="rounded-xl border border-border bg-muted/20 p-4">
          <h4 className="text-sm font-semibold mb-3">Product Comparison</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 pr-4 font-medium text-muted-foreground">Product</th>
                  <th className="text-right py-2 px-2 font-medium text-muted-foreground">Cost/hr</th>
                  <th className="text-left py-2 px-2 font-medium text-muted-foreground">Best For</th>
                  <th className="text-left py-2 px-2 font-medium text-muted-foreground">Key Features</th>
                </tr>
              </thead>
              <tbody>
                {(Object.entries(AZURE_PRODUCTS) as [AzureProductType, typeof currentProduct][]).map(
                  ([key, product]) => (
                    <tr key={key} className={`border-b border-border/50 ${selectedProduct === key ? "bg-primary/5" : ""}`}>
                      <td className="py-2 pr-4 font-medium">{product.label}</td>
                      <td className="text-right py-2 px-2 font-mono">
                        ${(product.pricing[selectedSize] / 100).toFixed(2)}
                      </td>
                      <td className="py-2 px-2 text-muted-foreground">
                        {product.bestFor.slice(0, 2).join(", ")}
                      </td>
                      <td className="py-2 px-2 text-muted-foreground">
                        {product.features.slice(0, 2).join(" • ")}
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-3 text-[10px] text-muted-foreground">
            <p>💡 <strong>Tip:</strong> Use Spot VMs for dev/test to save up to 90%. ACI is great for short-lived tasks with per-second billing.</p>
          </div>
        </div>
      )}

      {/* Best For */}
      <div className="rounded-lg border border-border/50 bg-card p-3">
        <div className="text-xs font-medium text-muted-foreground mb-2">Recommended For:</div>
        <ul className="space-y-1.5">
          {currentProduct.bestFor.map((use, idx) => (
            <li key={idx} className="text-xs text-foreground flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <span>{use}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
