import { defineCollection, z } from 'astro:content';

const services = defineCollection({
  type: 'data',
  schema: z.object({
    name: z.string(),
    slug: z.string(),
    price: z.string(),
    duration: z.string(),
    audience: z.string().nullable(),
    description: z.string(),
    bookingUrl: z.string().url(),
    featured: z.boolean(),
    order: z.number(),
  }),
});

const products = defineCollection({
  type: 'data',
  schema: z.object({
    name: z.string(),
    slug: z.string(),
    collection: z.string(),
    size: z.string(),
    price: z.number(),
    description: z.string(),
    howToUse: z.string().nullable(),
    ingredients: z.string(),
    imageUrl: z.string().url(),
    productUrl: z.string().url(),
    featured: z.boolean(),
    order: z.number(),
    /** Set true when imageUrl is a white-seamless studio shot. The shop
     * cards apply a vignette to mask the white edges so the bottle reads
     * against the dark card background like the other product photos. */
    whiteBg: z.boolean().optional(),
  }),
});

export const collections = { services, products };
