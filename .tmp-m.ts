import { providerNameMatchesEmployer } from './src/employer-icon-resolution.js';
for (const [p, d] of [['rendezvousrobotics','Rendezvous Robotics'],['lilasciences','Lila Sciences'],
  ['toshibaglobalcommercesolutions','Toshiba Global Commerce Solutions'],['rivetindustries.com','Rivet Industries'],
  ['Walleye Capital','Walleye Capital Internships'],['Acme','Acme Internship Program'],['Acme','Acme Co-Op'],
  ['Acme','Acme Summer 2026 Students']] as const) {
  console.log(providerNameMatchesEmployer(p, d) ? 'ok  ' : 'FAIL', p, '|', d);
}
