
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import axios from 'axios'
import fs from 'fs'
import path from 'path'
import { prisma } from '@/lib/prisma'

export const POST = async (request: NextRequest) => {
  try {
    console.log('Received POST request to /api/transcribe')

    // Read uploaded audio
    const formData = await request.formData()
    const file = formData.get('audio')

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: 'No valid audio file provided.' },
        { status: 400 }
      )
    }

    console.log('Received file:', file.name)

    // Validate environment variables
    const apiUrl = process.env.LANGFLOW_FLOW_URL
    const apiKey = process.env.LANGFLOW_API_KEY

    if (!apiUrl) {
      throw new Error('LANGFLOW_FLOW_URL is missing from .env.local')
    }

    if (!apiKey) {
      throw new Error('LANGFLOW_API_KEY is missing from .env.local')
    }

    // Save the uploaded audio
    const uploadsDir = path.join(process.cwd(), 'public', 'uploads')
    fs.mkdirSync(uploadsDir, { recursive: true })

    // Use a safe filename
    const safeOriginalName = path
      .basename(file.name)
      .replace(/[^a-zA-Z0-9._-]/g, '_')

    const fileName = `${Date.now()}-${safeOriginalName}`
    const filePath = path.join(uploadsDir, fileName)

    const arrayBuffer = await file.arrayBuffer()
    fs.writeFileSync(filePath, Buffer.from(arrayBuffer))

    console.log('Audio saved successfully:', fileName)
    console.log('Sending request to LangFlow')

    // Build LangFlow payload
    const payload = {
      output_type: 'text',
      input_type: 'text',
      tweaks: {
        'GroqWhisperComponent-Lep46': {
          audio_file: filePath,
        },
      },
    }

    // Execute LangFlow with API-key authentication
    const apiResponse = await axios.post(apiUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      timeout: 300000,
    })

    console.log('LangFlow response received')

    // Validate response
    const outputs = apiResponse.data?.outputs

    if (!Array.isArray(outputs) || !outputs[0]?.outputs) {
      console.error(
        'Unexpected LangFlow response:',
        JSON.stringify(apiResponse.data).slice(0, 1500)
      )

      throw new Error('LangFlow returned an unexpected response structure.')
    }

    const resultOutputs = outputs[0].outputs

    const analyzedTranscript =
      resultOutputs[0]?.results?.breakdown?.text

    const rawTranscript =
      resultOutputs[1]?.results?.transcription?.text

    if (!analyzedTranscript || !rawTranscript) {
      console.error(
        'Transcript fields missing from LangFlow response:',
        JSON.stringify(resultOutputs).slice(0, 1500)
      )

      throw new Error(
        'Transcript or meeting analysis is missing from the LangFlow response.'
      )
    }

    // Parse meeting analysis JSON
    let analyzedData: any

    try {
      analyzedData =
        typeof analyzedTranscript === 'string'
          ? JSON.parse(analyzedTranscript)
          : analyzedTranscript
    } catch {
      console.error(
        'Could not parse meeting analysis:',
        String(analyzedTranscript).slice(0, 1000)
      )

      throw new Error('LangFlow returned invalid meeting-analysis JSON.')
    }

    if (!analyzedData || typeof analyzedData !== 'object') {
      throw new Error('Meeting analysis has an invalid format.')
    }

    console.log('Meeting analysis parsed successfully')
    console.log('Saving meeting to database')

    // Safely format dates
    const formatDate = (date: string) => {
      const parsedDate = new Date(date)

      return !isNaN(parsedDate.getTime())
        ? parsedDate.toISOString()
        : null
    }

    // Safely handle expected array fields
    const getArray = (value: unknown): any[] =>
      Array.isArray(value) ? value : []

    // Save meeting and related records
    const meeting = await prisma.meeting.create({
      data: {
        name: analyzedData['Meeting Name'] || 'Untitled Meeting',

        description:
          analyzedData['Description'] || 'No description provided.',

        rawTranscript: String(rawTranscript),

        summary: analyzedData['Summary'] || '',

        tasks: {
          create: getArray(analyzedData['Tasks'])
            .filter((task) => task && typeof task === 'object')
            .map((task) => ({
              task: task.description || 'No task description',
              owner: task.owner || 'Unassigned',
              dueDate: task.due_date
                ? formatDate(task.due_date)
                : null,
            })),
        },

        decisions: {
          create: getArray(analyzedData['Decisions'])
            .filter(
              (decision) => decision && typeof decision === 'object'
            )
            .map((decision) => ({
              decision:
                decision.description || 'No decision description',
              date: decision.date
                ? formatDate(decision.date) || new Date().toISOString()
                : new Date().toISOString(),
            })),
        },

        questions: {
          create: getArray(analyzedData['Questions'])
            .filter(
              (question) => question && typeof question === 'object'
            )
            .map((question) => ({
              question: question.question || 'No question',
              status: question.status || 'Unanswered',
              answer: question.answer || '',
            })),
        },

        insights: {
          create: getArray(analyzedData['Insights'])
            .filter(
              (insight) => insight && typeof insight === 'object'
            )
            .map((insight) => ({
              insight: insight.insight || 'No insight',
              reference: insight.reference || '',
            })),
        },

        deadlines: {
          create: getArray(analyzedData['Deadlines'])
            .filter(
              (deadline) => deadline && typeof deadline === 'object'
            )
            .map((deadline) => ({
              description:
                deadline.description || 'No deadline description',
              dueDate: deadline.date
                ? formatDate(deadline.date)
                : null,
            })),
        },

        attendees: {
          create: getArray(analyzedData['Attendees'])
            .filter(
              (attendee) => attendee && typeof attendee === 'object'
            )
            .map((attendee) => ({
              name: attendee.name || 'Unnamed Attendee',
              role: attendee.role || 'No role specified',
            })),
        },

        followUps: {
          create: getArray(analyzedData['Follow-ups'])
            .filter(
              (followUp) => followUp && typeof followUp === 'object'
            )
            .map((followUp) => ({
              description:
                followUp.description || 'No follow-up description',
              owner: followUp.owner || 'Unassigned',
            })),
        },

        risks: {
          create: getArray(analyzedData['Risks'])
            .filter((risk) => risk && typeof risk === 'object')
            .map((risk) => ({
              risk: risk.risk || 'No risk description',
              impact: risk.impact || 'No impact specified',
            })),
        },

        agenda: {
          create: getArray(analyzedData['Agenda'])
            .filter((item) => typeof item === 'string')
            .map((item: string) => ({
              item,
            })),
        },
      },

      include: {
        tasks: true,
        decisions: true,
        questions: true,
        insights: true,
        deadlines: true,
        attendees: true,
        followUps: true,
        risks: true,
        agenda: true,
      },
    })

    console.log('Meeting saved successfully:', meeting.id)

    return NextResponse.json(meeting, { status: 200 })
  } catch (error: unknown) {
    if (axios.isAxiosError(error)) {
      console.error('LangFlow request failed:', {
        status: error.response?.status,
        message: error.message,
        // Do not log request headers because they contain the API key.
        response: JSON.stringify(error.response?.data).slice(0, 2000),
      })

      return NextResponse.json(
        {
          error: 'LangFlow processing failed.',
          details:
            process.env.NODE_ENV === 'development'
              ? `HTTP ${error.response?.status ?? 'unknown'}: ${
                  error.message
                }`
              : undefined,
        },
        { status: 502 }
      )
    }

    console.error('Error in /api/transcribe:', error)

    const message =
      error instanceof Error ? error.message : 'Unknown processing error'

    return NextResponse.json(
      {
        error: 'An error occurred during processing.',
        details:
          process.env.NODE_ENV === 'development' ? message : undefined,
      },
      { status: 500 }
    )
  }
}
