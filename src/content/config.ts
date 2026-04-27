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
  }),
});

export const collections = { services, products };
