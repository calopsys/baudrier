import { glob } from "astro/loaders";
import { defineCollection, z } from "astro:content";

const blog = defineCollection({
  loader: glob({ pattern: "*.md", base: "./src/content/blog" }),
  schema: ({ image }) =>
    z
      .object({
        title: z.string(),
        description: z.string(),
        pubDate: z.coerce.date(),
        updatedDate: z.coerce.date().optional(),
        tags: z.array(z.string()).default([]),
        cover: image().optional(),
        coverAlt: z.string().optional(),
      })
      .refine((post) => !post.cover || !!post.coverAlt, {
        message: "coverAlt est obligatoire quand cover est défini.",
        path: ["coverAlt"],
      }),
});

export const collections = { blog };
