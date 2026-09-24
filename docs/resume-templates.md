# Resume templates

Ntern renders every final resume from one strongly typed document. The content
model owns contact fields, education entries, experience entries, research
entries, project entries, skill groups, and parent-bound bullets. Templates may
change typography, spacing, and section priority; they cannot change bullet
ownership or reinterpret stored facts.

## Included templates

| Template | Intended use | Layout |
| --- | --- | --- |
| Jake's Technical | Software, data, ML, and infrastructure roles | Dense single column; education, experience, research, projects, skills |
| Clean Standard | General technical and product roles | Roomier sans-serif single column |
| Research First | Labs, research engineering, and graduate opportunities | Education and research lead |
| Project Compact | Students with substantial independent work | Dense single column with projects before employment |

Jake's Technical is an original fixed renderer informed by the hierarchy and
ATS-safe conventions of [sb2nov/resume](https://github.com/sb2nov/resume),
which is MIT licensed. Clean Standard, Research First, and Project Compact are
Ntern layouts built on the same typed renderer. We do not accept uploaded
LaTeX templates or compile user-controlled commands.

The two-column Deedy resume was evaluated as a source of template ideas but is
not shipped: its column constraints make dense undergraduate technical content
harder to scan and introduce avoidable parsing risk. Its upstream project is
Apache-2.0 licensed: [deedy/Deedy-Resume](https://github.com/deedy/Deedy-Resume).

## Compatibility

Older bank rows that contain only `content` are normalized into typed details
at render time. Every new manual or document-imported parent record stores its
validated details explicitly. Bullets always carry a typed pointer to one role,
research entry, project, or education entry; the renderer joins through that
pointer and never through section text or row proximity.
