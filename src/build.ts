/** Ταυτότητα της έκδοσης που τρέχει: αλλάζει σε κάθε ανέβασμα. */
export const BUILD = process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || "dev";
