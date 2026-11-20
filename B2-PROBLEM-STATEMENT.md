# B2 Fair tickets — problem statement and hackathon context

## Supplied problem statement

**CYBERSECURITY AND BLOCKCHAIN · B2**

**Fair tickets**

**1.3 crore fans in the queue. Sold out within minutes.**

- **1.3 crore** people in BookMyShow's online queue for Coldplay's three Mumbai concerts, September 2024.
- **₹3 lakh** asking price for some Coldplay tickets on resale websites, many times the face price.
- **5 cities**, including Bengaluru, raided by the Enforcement Directorate over fake concert tickets, October 2024.

### Background

In September 2024, BookMyShow opened sales for Coldplay's three Mumbai concerts, held in January 2025. About 1.3 crore people joined the online queue, and the tickets sold out within minutes. Within hours, tickets appeared on resale websites for up to ₹3 lakh. A complaint to the Mumbai police alleged that bots had taken lakhs of places in the queue. The Economic Offences Wing of the Mumbai police questioned BookMyShow executives. BookMyShow denied any link with resale websites and filed its own police complaint.

Fake tickets are a second problem. In October 2024, the Enforcement Directorate raided locations in five cities, including Bengaluru, over fake tickets for Coldplay and Diljit Dosanjh concerts. Sellers had offered these tickets on Instagram, WhatsApp and Telegram. Delhi police arrested people who sold fake tickets for Diljit Dosanjh's Delhi concert. India has no law written specifically against ticket scalping.

### Who this affects

Fans who want to attend a concert, match or festival at the price the organiser set. It also affects the artists and organisers who want their tickets to reach real fans.

### The problem

Bots and scalpers buy up tickets as soon as sales open. Fake tickets are sold on social media. Real fans pay several times the face price, or get no ticket at all.

### The challenge

> Design a ticketing system where fans get tickets at a fair price, resale is possible but cannot be exploited, and a fake ticket is useless at the gate.

### Key terms

- **Scalper.** A person who buys tickets in order to resell them at a higher price.
- **Bot.** Software that joins queues and buys tickets automatically, faster than a person can.
- **Face price.** The price the organiser set when the ticket was first sold.
- **Resale.** Selling a ticket you bought to another person.
- **The gate.** The venue entrance, where staff check each ticket before letting the holder in.

The background above reproduces the supplied brief with layout cleanup. The account of bots in the Coldplay queue is an allegation in the brief. The legal sentence is also part of the supplied wording, with no independent legal update in this file. [Original brief in Choose Best Track](chatgpt-conversation://6b000085-75b0-83ec-b894-17d6b8b9659a)

## Hackathon and decision context

- **Competition.** The team has 20 hours. About 90 teams have access to the same problem statements, resources and tools. The judges are from IBM, and the top three prizes are awarded across all tracks.
- **Team split.** One developer builds B2 while the other works independently on R1, *Vibe-coded and vulnerable*, during the first two hours. At the checkpoint, choose which project both developers will continue for the remaining 18 hours based on what each has demonstrated.
- **Comparison.** Give each developer five minutes to demo and report failures and remaining work. Both bring a working repo, test output, and a 60-second demo with one successful case and one rejected attempt. Score the agreed criteria from 0 to 5, where 0 means no evidence, 3 means partial evidence, and 5 means independently tested. Use predefined tests and the working demo as evidence. If both projects underperform, reconsider scope before committing the remaining time. [Original comparison discussion](chatgpt-conversation://6b000085-75b0-83ec-b894-17d6b8b9659a)

## Later clarifications from the team

- **Blockchain requirement.** Blockchain must perform a core function that the product depends on. The requirement rules out a design that would function substantially the same way with the chain removed. Local and hosted chains are both allowed.
- **Previous infrastructure attempt.** The team tried Polygon Amoy and ran into rate limits and insufficient free test gas. The team asked to verify a high-volume option up front and stick with that choice throughout the hackathon.
- **Volume context.** The supplied research screenshot uses 100,000 blockchain operations in 20 hours as its planning target. The design adopts the stricter working interpretation of 100,000 successful mined contract writes, with its own acceptance run. The original two-hour checkpoint is the separate seven-test ticketing benchmark.
