import { defineCollection, z } from "astro:content";

const blog = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    cover: z.string().optional(),
    draft: z.boolean().default(false),
  }),
});

// המלצות לקוחות — לכל המלצה קובץ. מוצגת באתר רק אם approved=true.
const testimonials = defineCollection({
  type: "content",
  schema: z.object({
    name: z.string().default("לקוח/ה"),
    city: z.string().optional().default(""),
    rating: z.coerce.number().min(1).max(5).default(5),
    approved: z.boolean().default(false),
    date: z.coerce.date().optional(),
  }),
});

export const collections = { blog, testimonials };
