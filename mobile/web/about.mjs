import { topicLinks } from "./topics.mjs";

export const aboutPage = {
  title: "About Ntern — Technical internships and early-career roles",
  description: "Learn how Ntern helps students and new graduates find technical internships and early-career roles, with a direct path to official employer applications.",
  path: "/about",
  body: `<h1>About Ntern</h1>
    <p class="lede">Ntern is a free early-career radar for students and new graduates. Find technical internships, co-ops, apprenticeships, and entry-level opportunities without refreshing dozens of career sites.</p>
    <h2>How it works</h2>
    <p>Browse without an account. Ntern brings together reviewed employer career feeds and attributed community sources, with source labels so you can see where a listing came from. Applications always open on the employer’s official site, where you review the full requirements and submit yourself.</p>
    <p>Set role preferences and device alerts without signing in. Create an account when you want to sync saved applications or store a résumé or profile.</p>
    <h2>Find your next role</h2>
    <p><a href="/jobs">Browse open technical roles</a>, or explore a specific path.</p>
    ${topicLinks()}
    <p><a class="primary" href="/">Open Ntern</a></p>`,
};
