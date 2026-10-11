import type { Metadata } from "next";
import { ProductBoot } from "./product-boot";
import { productMarkup } from "./product-markup";

export const metadata: Metadata = { title: "OffLane App" };

export default function ProductPage() {
  return (
    <>
      <link rel="stylesheet" href="/app/product.css" />
      <div dangerouslySetInnerHTML={{ __html: productMarkup }} />
      <ProductBoot />
    </>
  );
}
