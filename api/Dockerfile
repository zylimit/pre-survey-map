FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
ARG PIP_INDEX=https://pypi.org/simple
RUN pip install --no-cache-dir -i ${PIP_INDEX} -r requirements.txt

COPY . .

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
